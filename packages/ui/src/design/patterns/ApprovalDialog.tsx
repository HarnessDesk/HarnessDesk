import { forwardRef, useLayoutEffect, useState, type ComponentProps, type ReactNode } from 'react'

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

/** A compact labelled value that locates an approved action. */
export const ApprovalMeta = ({ label, className, children, ...props }: ComponentProps<'div'> & {
  label: ReactNode
}) => (
  <div data-slot="approval-meta" className={`${styles.meta} ${className ?? ''}`} {...props}>
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
 */
export const ApprovalDialog = forwardRef<HTMLDivElement, {
  title: string
  icon: ReactNode
  queue?: string
  focused: boolean
  focusKey: string
  actions: readonly ApprovalDialogAction[]
  children: ReactNode
}>(({
  title,
  icon,
  queue,
  focused,
  focusKey,
  actions,
  children,
}, forwardedRef) => {
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null)
  const [surface, setSurface] = useState<HTMLDivElement | null>(null)
  const safe = actions.filter((action) => action.placement === 'safe')
  const proceed = actions.filter((action) => action.placement === 'proceed')

  useLayoutEffect(() => {
    if (!focused || !surface) return
    const returnTo = document.activeElement as HTMLElement | null
    surface.focus()
    return () => returnTo?.focus?.()
  }, [focused, focusKey, surface])

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

const Action = ({ action }: { action: ApprovalDialogAction }) => (
  <Button
    className={styles.action}
    variant={action.tone === 'destructive' ? 'destructive' : action.placement === 'proceed' ? 'default' : 'secondary'}
    onClick={action.onSelect}
    title={action.description}
  >
    {action.icon}
    {action.label}
    <span className={styles.shortcut}>{action.shortcut}</span>
  </Button>
)
