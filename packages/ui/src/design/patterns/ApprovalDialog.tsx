import { forwardRef, useId, useLayoutEffect, useState, type ComponentProps, type ReactNode } from 'react'

import { Button } from '../ui/button'
import {
  Dialog,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from '../ui/dialog'
import styles from './ApprovalDialog.module.css'

export type ApprovalDialogAction = {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  shortcut: number
  placement: 'safe' | 'proceed'
  tone?: 'default' | 'destructive'
  onSelect: () => void
}

/** Explanatory copy inside an approval. */
export const ApprovalReason = ({ className, ...props }: ComponentProps<'p'>) => (
  <p data-slot="approval-reason" className={`${styles.reason} ${className ?? ''}`} {...props} />
)

/** Verbatim command, input or schema text inside an approval. */
export const ApprovalCode = ({ className, ...props }: ComponentProps<'pre'>) => (
  <pre data-slot="approval-code" className={`${styles.code} ${className ?? ''}`} {...props} />
)

/**
 * A compact labelled value that locates an approved action.
 *
 * `kind="folder"` is a place, not something a shell reads: it is set in the
 * interface's own type, the way every other branch, folder and file name in
 * the app is (`docs/design.md`), and only a command keeps the code face.
 */
export const ApprovalMeta = ({ label, kind = 'code', className, children, ...props }: ComponentProps<'div'> & {
  label: ReactNode
  kind?: 'code' | 'folder'
}) => (
  <div data-slot="approval-meta" data-kind={kind} className={`${styles.meta} ${className ?? ''}`} {...props}>
    <span className={styles.metaLabel}>{label}</span>
    <span className={styles.metaValue}>{children}</span>
  </div>
)

/** A file named by an approval, as a copyable path rather than prose. */
export const ApprovalFilePath = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="approval-file-path" className={`${styles.filePath} ${className ?? ''}`} {...props} />
)

/** Files or hosts covered by a permission request. */
export const ApprovalPermissionList = ({ className, ...props }: ComponentProps<'ul'>) => (
  <ul data-slot="approval-permission-list" className={`${styles.permissionList} ${className ?? ''}`} {...props} />
)

/** The question an approval asks before its choice rows. */
export const ApprovalQuestionText = ({ className, ...props }: ComponentProps<'p'>) => (
  <p data-slot="approval-question" className={`${styles.questionText} ${className ?? ''}`} {...props} />
)

/** The consequence that earns a second line under an approval choice. */
export const ApprovalChoiceHint = ({ className, ...props }: ComponentProps<'span'>) => (
  <span data-slot="approval-choice-hint" className={`${styles.choiceHint} ${className ?? ''}`} {...props} />
)

/**
 * The pane-local approval surface. Base UI owns focus containment, Escape,
 * dismissal semantics, and screen-reader dialog behavior; this pattern keeps
 * the safety policy explicit and keeps the portal inside its conversation.
 *
 * `placement="docked"` is the same question in a composer's slot instead: a
 * card in normal flow, as wide as the composer it stands in for, with the
 * thread above it left fully readable — no scrim, no blur, no portal, not a
 * dialog. A room is where this happens: a member waiting on a person takes
 * the room's composer rather than covering the conversation everyone else in
 * it is reading. It has exactly one filled act, the plain approve, like any
 * footer in the app; every other answer is quiet, and its number still works.
 */
export const ApprovalDialog = forwardRef<HTMLDivElement, {
  title: string
  icon: ReactNode
  queue?: string
  focused: boolean
  focusKey: string
  actions: readonly ApprovalDialogAction[]
  placement?: 'overlay' | 'docked'
  children: ReactNode
}>(({
  title,
  icon,
  queue,
  focused,
  focusKey,
  actions,
  placement = 'overlay',
  children,
}, forwardedRef) => {
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null)
  const [surface, setSurface] = useState<HTMLElement | null>(null)
  const titleId = useId()
  const safe = actions.filter((action) => action.placement === 'safe')
  const proceed = actions.filter((action) => action.placement === 'proceed')

  useLayoutEffect(() => {
    if (!focused || !surface) return
    const returnTo = document.activeElement as HTMLElement | null
    surface.focus()
    /* Docked, `focused` means only "take the focus the composer had": the
       slot's owner knows where focus belongs when the card goes (the
       composer it stood in for, and only if the person was still there), so
       the card hands nothing back of its own. */
    if (placement === 'docked') return
    return () => returnTo?.focus?.()
  }, [focused, focusKey, surface, placement])

  if (placement === 'docked') {
    /* The one filled act is the last approving answer — the plain yes, which
       `Approvals` already sorts rightmost — and everything else is quiet. */
    const act = proceed[proceed.length - 1]?.id
    return (
      <section
        ref={(node) => {
          setSurface(node)
          if (typeof forwardedRef === 'function') forwardedRef(node as HTMLDivElement | null)
          else if (forwardedRef) forwardedRef.current = node as HTMLDivElement | null
        }}
        data-slot="approval-card"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.docked}
      >
        <div className={styles.header}>
          <span className={styles.icon}>{icon}</span>
          <h2 id={titleId} className={styles.title}>{title}</h2>
          {queue ? <span className={styles.queue}>{queue}</span> : null}
        </div>
        <div className={styles.body}>{children}</div>
        <div className={styles.footer} data-slot="approval-choices">
          {safe.map((action) => (
            <Action key={action.id} action={action} variant="quiet" />
          ))}
          <span className={styles.spacer} />
          {proceed.map((action) => (
            <Action key={action.id} action={action} variant={action.id === act ? 'default' : 'quiet'} />
          ))}
        </div>
      </section>
    )
  }

  return (
    <div
      ref={(node) => {
        setPortalHost(node)
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      }}
      className={styles.scope}
      data-slot="approval-dialog-scope"
    >
      <Dialog
        open
        modal={false}
        disablePointerDismissal
        onOpenChange={(open, details) => {
          if (open) return
          if (details.reason === 'escape-key') {
            details.cancel()
            details.allowPropagation()
          }
        }}
      >
        {portalHost ? <DialogPortal container={portalHost} className={styles.portal}>
          <DialogOverlay className={styles.backdrop} />
          <DialogViewport className={styles.viewport}>
            <DialogPopup
              ref={setSurface}
              className={styles.dialog}
              initialFocus={false}
              finalFocus={false}
              aria-describedby={undefined}
              tabIndex={-1}
            >
              <div className={styles.header}>
                <span className={styles.icon}>{icon}</span>
                <DialogTitle className={styles.title}>{title}</DialogTitle>
                {queue ? <span className={styles.queue}>{queue}</span> : null}
              </div>
              <div className={styles.body}>{children}</div>
              <div className={styles.footer}>
                {safe.map((action) => (
                  <Action key={action.id} action={action} />
                ))}
                <span className={styles.spacer} />
                {proceed.map((action) => (
                  <Action key={action.id} action={action} />
                ))}
              </div>
            </DialogPopup>
          </DialogViewport>
        </DialogPortal> : null}
      </Dialog>
    </div>
  )
})
ApprovalDialog.displayName = 'ApprovalDialog'

const Action = ({ action, variant }: {
  action: ApprovalDialogAction
  /** The docked card's own choice; the overlay reads the action's tone and placement. */
  variant?: 'default' | 'quiet'
}) => (
  <Button
    className={styles.action}
    variant={variant ?? (action.tone === 'destructive' ? 'destructive' : action.placement === 'proceed' ? 'default' : 'secondary')}
    onClick={action.onSelect}
    title={action.description}
  >
    {action.icon}
    {action.label}
    <span className={styles.shortcut}>{action.shortcut}</span>
  </Button>
)
